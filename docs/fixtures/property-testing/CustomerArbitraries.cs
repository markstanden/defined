// Fixture-only split: the generator has its own file so the marked snippet is
// self-contained. In a real suite the placement rule in
// standards/testing/property-testing.md decides between the law file and
// TestData/Arbitraries/.
using System.Linq;

using System.Collections.Generic;
using FsCheck;
using FsCheck.Fluent;

public static class CustomerArbitraries
{
    /// <summary>
    /// A representative customer from the documented XML contract: the name set
    /// the contract admits and an id from the positive range.
    /// </summary>
    public static Arbitrary<Customer> ValidCustomer()
    {
        Gen<string> name = Gen.Elements("Ada", "Grace", "Alan");
        Gen<int> id = Gen.Choose(1, 100_000);
        Gen<Customer> customer = from customerName in name
                                 from customerId in id
                                 select new Customer(customerId, customerName);
        return Arb.From(customer, ShrinkCustomer);
    }

    /// <summary>Shrinks the id to the documented minimum, staying inside the domain.</summary>
    private static IEnumerable<Customer> ShrinkCustomer(Customer customer)
    {
        if (customer.Id > 1)
        {
            yield return customer with { Id = 1 };
        }
    }
}
